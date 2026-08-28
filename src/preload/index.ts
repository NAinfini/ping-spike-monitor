import { contextBridge, ipcRenderer } from 'electron'
import type {
  Incident,
  MonitorApi,
  MonitorTarget,
  OverviewSnapshot,
  ProbeSample,
  SeriesPoint,
  SeriesQuery,
  WindowControlsApi
} from '../shared/types'

const api: MonitorApi = {
  getOverview: () => ipcRenderer.invoke('monitor:overview') as Promise<OverviewSnapshot>,
  getSeries: (query: SeriesQuery) =>
    ipcRenderer.invoke('monitor:series', query) as Promise<SeriesPoint[]>,
  getIncidents: () => ipcRenderer.invoke('monitor:incidents') as Promise<Incident[]>,
  getTargets: () => ipcRenderer.invoke('monitor:targets') as Promise<MonitorTarget[]>,
  onSample: (listener: (sample: ProbeSample) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sample: ProbeSample): void => listener(sample)
    ipcRenderer.on('monitor:sample-event', handler)
    return () => ipcRenderer.removeListener('monitor:sample-event', handler)
  },
  onOverview: (listener: (overview: OverviewSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, overview: OverviewSnapshot): void =>
      listener(overview)
    ipcRenderer.on('monitor:overview-event', handler)
    return () => ipcRenderer.removeListener('monitor:overview-event', handler)
  }
}

const windowControls: WindowControlsApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized)
    ipcRenderer.on('window:maximized-event', handler)
    return () => ipcRenderer.removeListener('window:maximized-event', handler)
  }
}

contextBridge.exposeInMainWorld('monitor', api)
contextBridge.exposeInMainWorld('windowControls', windowControls)
