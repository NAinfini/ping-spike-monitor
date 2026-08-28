export type TargetKind = 'gateway' | 'public' | 'isp' | 'region' | 'dns' | 'https'
export type ProbeMethod = 'icmp' | 'tcp' | 'dns' | 'https'
export type SampleStatus = 'ok' | 'timeout' | 'error' | 'skipped'
export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'warming' | 'unknown'

export interface MonitorTarget {
  id: string
  name: string
  kind: TargetKind
  region: string | null
  address: string
  method: ProbeMethod
  intervalMs: number
  timeoutMs: number
  enabled: boolean
}

export interface ProbeSample {
  id?: number
  targetId: string
  scheduledAt: number
  completedAt: number
  status: SampleStatus
  rttMs: number | null
  errorCode: string | null
  loadRunId: string | null
}

export interface TargetHealth {
  target: MonitorTarget
  status: HealthStatus
  latestRttMs: number | null
  baselineMs: number | null
  jitterMs: number | null
  packetLossPct: number
  lastSampleAt: number | null
}

export type IncidentScope = 'local' | 'isp' | 'internet' | 'region' | 'endpoint'

export interface Incident {
  id: string
  startedAt: number
  endedAt: number | null
  scope: IncidentScope
  region: string | null
  severity: 'warning' | 'critical'
  confidence: 'low' | 'medium' | 'high'
  summary: string
  evidence: string[]
}

export interface OverviewSnapshot {
  collectorStartedAt: number
  lastUpdatedAt: number
  status: HealthStatus
  targetHealth: TargetHealth[]
  activeIncident: Incident | null
  recentIncidents: Incident[]
}

export interface SeriesPoint {
  timestamp: number
  targetId: string
  minMs: number | null
  avgMs: number | null
  maxMs: number | null
  packetLossPct: number
}

export interface SeriesQuery {
  from: number
  to: number
  targetIds: string[]
  maxPoints?: number
}

export interface CollectorRequest {
  type: 'request'
  requestId: string
  method: 'overview' | 'series' | 'incidents' | 'targets'
  args?: unknown
}

export interface CollectorResponse {
  type: 'response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface CollectorEvent {
  type: 'event'
  event: 'sample' | 'overview'
  payload: unknown
}

export type CollectorMessage = CollectorResponse | CollectorEvent

export interface MonitorApi {
  getOverview(): Promise<OverviewSnapshot>
  getSeries(query: SeriesQuery): Promise<SeriesPoint[]>
  getIncidents(): Promise<Incident[]>
  getTargets(): Promise<MonitorTarget[]>
  onSample(listener: (sample: ProbeSample) => void): () => void
  onOverview(listener: (overview: OverviewSnapshot) => void): () => void
}

export interface WindowControlsApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}
