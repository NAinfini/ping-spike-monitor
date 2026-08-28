import { join } from 'node:path'
import type {
  CollectorEvent,
  CollectorMessage,
  CollectorRequest,
  CollectorResponse,
  MonitorTarget,
  ProbeSample,
  SeriesQuery
} from '../shared/types'
import { HealthTracker, IncidentTracker } from './health'
import { discoverDefaultGateway, pingTarget } from './probe'
import { AbsoluteScheduler } from './scheduler'
import { CollectorStorage } from './storage'

type Probe = (target: MonitorTarget, scheduledAt: number) => Promise<ProbeSample>
type GatewayDiscovery = () => Promise<string | null>
type EventListener = (event: CollectorEvent) => void

export interface CollectorRuntimeOptions {
  storage?: CollectorStorage
  dataDirectory?: string
  probe?: Probe
  discoverGateway?: GatewayDiscovery
  now?: () => number
}

export function resolveCollectorDataDirectory(environment = process.env): string {
  return environment.PING_SPIKE_DATA_DIR ?? join(environment.LOCALAPPDATA ?? process.cwd(), 'PingSpikeMonitor')
}

export class CollectorRuntime {
  private readonly storage: CollectorStorage
  private readonly probe: Probe
  private readonly discoverGateway: GatewayDiscovery
  private readonly now: () => number
  private readonly health = new HealthTracker()
  private readonly incidents = new IncidentTracker()
  private readonly listeners = new Set<EventListener>()
  private readonly scheduler: AbsoluteScheduler
  private readonly startedAt: number
  private targets: MonitorTarget[] = []
  private lastUpdatedAt: number
  private started = false
  private stopped = false

  public constructor(options: CollectorRuntimeOptions = {}) {
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    this.lastUpdatedAt = this.startedAt
    this.storage =
      options.storage ??
      new CollectorStorage(join(options.dataDirectory ?? resolveCollectorDataDirectory(), 'monitor.sqlite'))
    this.probe = options.probe ?? ((target, scheduledAt) => pingTarget(target, scheduledAt))
    this.discoverGateway = options.discoverGateway ?? discoverDefaultGateway
    this.scheduler = new AbsoluteScheduler((target, scheduledAt) => this.collect(target, scheduledAt), this.now)
  }

  public async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.storage.closeInterruptedIncidents()
    let gateway: string | null = null
    try {
      gateway = await this.discoverGateway()
    } catch {
      gateway = null
    }
    this.targets = this.storage.seedDefaultTargets(gateway)
    this.health.hydrate(this.targets, this.storage.loadSamplesSince(this.startedAt - 6 * 60 * 60 * 1_000))
    this.scheduler.replaceTargets(this.targets.filter((target) => target.method === 'icmp'))
    this.scheduler.start()
    this.emitOverview()
  }

  public stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.scheduler.stop()
    this.storage.close()
  }

  public onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public getOverview() {
    return this.storage.getOverview(
      this.startedAt,
      this.health.getAll(this.targets),
      this.incidents.getActive(),
      this.lastUpdatedAt
    )
  }

  public async handleRequest(request: CollectorRequest): Promise<CollectorResponse> {
    try {
      switch (request.method) {
        case 'overview':
          return success(request.requestId, this.getOverview())
        case 'targets':
          return success(request.requestId, this.storage.listTargets())
        case 'incidents':
          return success(request.requestId, this.storage.listIncidents())
        case 'series':
          if (!isSeriesQuery(request.args)) throw new Error('Invalid series query')
          return success(request.requestId, this.storage.querySeries(request.args))
      }
    } catch (error) {
      return failure(request.requestId, error instanceof Error ? error.message : 'Collector request failed')
    }
  }

  private async collect(target: MonitorTarget, scheduledAt: number): Promise<void> {
    let rawSample: ProbeSample
    try {
      rawSample = await this.probe(target, scheduledAt)
    } catch {
      rawSample = {
        targetId: target.id,
        scheduledAt,
        completedAt: this.now(),
        status: 'error',
        rttMs: null,
        errorCode: 'probe-failed',
        loadRunId: null
      }
    }
    const sample = this.storage.writeSample(rawSample)
    this.lastUpdatedAt = sample.completedAt
    const assessment = this.health.record(target, sample)
    const change = this.incidents.record(target, sample, assessment)
    if (change.opened) this.storage.writeIncident(change.opened)
    if (change.updated) this.storage.writeIncident(change.updated)
    if (change.resolved) this.storage.writeIncident(change.resolved)
    this.emit({ type: 'event', event: 'sample', payload: sample })
    this.emitOverview()
  }

  private emitOverview(): void {
    this.emit({ type: 'event', event: 'overview', payload: this.getOverview() })
  }

  private emit(event: CollectorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function success(requestId: string, result: unknown): CollectorResponse {
  return { type: 'response', requestId, ok: true, result }
}

function failure(requestId: string, error: string): CollectorResponse {
  return { type: 'response', requestId, ok: false, error }
}

function isSeriesQuery(value: unknown): value is SeriesQuery {
  if (!value || typeof value !== 'object') return false
  const query = value as Partial<SeriesQuery>
  return (
    typeof query.from === 'number' &&
    Number.isFinite(query.from) &&
    typeof query.to === 'number' &&
    Number.isFinite(query.to) &&
    Array.isArray(query.targetIds) &&
    query.targetIds.length <= 64 &&
    query.targetIds.every((targetId) => typeof targetId === 'string' && targetId.length <= 128) &&
    (query.maxPoints === undefined ||
      (typeof query.maxPoints === 'number' && Number.isFinite(query.maxPoints)))
  )
}

interface CollectorPort {
  postMessage(message: CollectorMessage): void
  on(event: 'message', listener: (event: unknown) => void): unknown
  start?: () => void
}

function eventData(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event) {
    return (event as { data: unknown }).data
  }
  return event
}

function isCollectorRequest(value: unknown): value is CollectorRequest {
  const request = value as Partial<CollectorRequest>
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    request.type === 'request' &&
    typeof request.requestId === 'string' &&
    (request.method === 'overview' ||
      request.method === 'series' ||
      request.method === 'incidents' ||
      request.method === 'targets')
  )
}

export async function startUtilityProcess(port: CollectorPort): Promise<CollectorRuntime> {
  let runtime: CollectorRuntime | null = null
  try {
    runtime = new CollectorRuntime()
    runtime.onEvent((event) => port.postMessage(event))
    port.on('message', (event) => {
      const request = eventData(event)
      if (!isCollectorRequest(request)) return
      const activeRuntime = runtime
      if (!activeRuntime) return
      void activeRuntime.handleRequest(request).then((response) => port.postMessage(response))
    })
    port.start?.()
    await runtime.start()
    return runtime
  } catch (error) {
    runtime?.stop()
    throw error
  }
}

const parentPort = (process as typeof process & { parentPort?: CollectorPort }).parentPort
if (parentPort) {
  void startUtilityProcess(parentPort).catch((error: unknown) => {
    console.error('Collector startup failed', error)
    process.exit(1)
  })
}
