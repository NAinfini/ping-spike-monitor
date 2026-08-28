import { randomUUID } from 'node:crypto'
import type {
  Incident,
  MonitorTarget,
  ProbeSample,
  TargetHealth
} from '../shared/types'

export interface HealthOptions {
  baselineWindowMs: number
  minimumBaselineDurationMs: number
  minimumBaselineSamples: number
  metricSampleCount: number
  warningFloorMs: number
  criticalFloorMs: number
  warningMadMultiplier: number
  criticalMadMultiplier: number
  minimumWarningIncreaseMs: number
  minimumCriticalIncreaseMs: number
}

const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
  baselineWindowMs: 6 * 60 * 60 * 1_000,
  minimumBaselineDurationMs: 30 * 60 * 1_000,
  minimumBaselineSamples: 10,
  metricSampleCount: 20,
  warningFloorMs: 100,
  criticalFloorMs: 300,
  warningMadMultiplier: 6,
  criticalMadMultiplier: 12,
  minimumWarningIncreaseMs: 20,
  minimumCriticalIncreaseMs: 100
}

export interface TargetAssessment {
  health: TargetHealth
  anomalous: boolean
  severe: boolean
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) return null
  if (sorted.length % 2 === 1) return upper
  const lower = sorted[middle - 1]
  return lower === undefined ? upper : (lower + upper) / 2
}

function successfulRtts(samples: readonly ProbeSample[]): number[] {
  return samples.flatMap((sample) => (sample.status === 'ok' && sample.rttMs !== null ? [sample.rttMs] : []))
}

function calculateJitter(samples: readonly ProbeSample[]): number | null {
  const values = successfulRtts(samples)
  if (values.length < 2) return null

  let total = 0
  for (let index = 1; index < values.length; index += 1) {
    total += Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0))
  }
  return total / (values.length - 1)
}

function calculatePacketLoss(samples: readonly ProbeSample[]): number {
  if (samples.length === 0) return 0
  return (samples.filter((sample) => sample.status === 'timeout').length / samples.length) * 100
}

export function assessTarget(
  target: MonitorTarget,
  history: readonly ProbeSample[],
  sample: ProbeSample,
  partialOptions: Partial<HealthOptions> = {}
): TargetAssessment {
  const options = { ...DEFAULT_HEALTH_OPTIONS, ...partialOptions }
  const healthyHistory = successfulRtts(history)
  const baselineMs = median(healthyHistory)
  const mad =
    baselineMs === null
      ? 0
      : (median(healthyHistory.map((rttMs) => Math.abs(rttMs - baselineMs))) ?? 0)
  const recentSamples = [...history, sample].slice(-options.metricSampleCount)
  const recentSuccessful = recentSamples.filter((candidate) => candidate.status === 'ok')
  const firstSampleAt = history[0]?.completedAt ?? sample.completedAt
  const baselineReady =
    healthyHistory.length >= options.minimumBaselineSamples &&
    sample.completedAt - firstSampleAt >= options.minimumBaselineDurationMs
  const warningThreshold =
    !baselineReady || baselineMs === null
      ? options.warningFloorMs
      : Math.max(
          options.warningFloorMs,
          baselineMs + Math.max(options.minimumWarningIncreaseMs, mad * options.warningMadMultiplier)
        )
  const criticalThreshold =
    !baselineReady || baselineMs === null
      ? options.criticalFloorMs
      : Math.max(
          options.criticalFloorMs,
          baselineMs + Math.max(options.minimumCriticalIncreaseMs, mad * options.criticalMadMultiplier)
        )
  const isTimeout = sample.status === 'timeout'
  const isLatencySpike = sample.status === 'ok' && sample.rttMs !== null && sample.rttMs >= warningThreshold
  const isSevereLatency = sample.status === 'ok' && sample.rttMs !== null && sample.rttMs >= criticalThreshold

  const status = isTimeout
    ? 'down'
    : sample.status !== 'ok' || sample.rttMs === null
      ? 'unknown'
      : isLatencySpike
        ? 'degraded'
        : !baselineReady || recentSuccessful.length < options.minimumBaselineSamples
          ? 'warming'
          : 'healthy'

  return {
    health: {
      target,
      status,
      latestRttMs: sample.rttMs,
      baselineMs,
      jitterMs: calculateJitter(recentSamples),
      packetLossPct: calculatePacketLoss(recentSamples),
      lastSampleAt: sample.completedAt
    },
    anomalous: status === 'degraded' || status === 'down',
    severe: isTimeout || isSevereLatency
  }
}

export class HealthTracker {
  private readonly histories = new Map<string, ProbeSample[]>()
  private readonly healthByTargetId = new Map<string, TargetHealth>()

  public constructor(private readonly options: Partial<HealthOptions> = {}) {}

  public record(target: MonitorTarget, sample: ProbeSample): TargetAssessment {
    const cutoff = sample.completedAt - (this.options.baselineWindowMs ?? DEFAULT_HEALTH_OPTIONS.baselineWindowMs)
    const history = (this.histories.get(target.id) ?? []).filter(
      (candidate) => candidate.completedAt >= cutoff
    )
    const assessment = assessTarget(target, history, sample, this.options)
    history.push(sample)
    this.histories.set(target.id, history)
    this.healthByTargetId.set(target.id, assessment.health)
    return assessment
  }

  public hydrate(targets: readonly MonitorTarget[], samples: readonly ProbeSample[]): void {
    const byId = new Map(targets.map((target) => [target.id, target]))
    for (const sample of samples) {
      const target = byId.get(sample.targetId)
      if (target) this.record(target, sample)
    }
  }

  public getAll(targets: readonly MonitorTarget[]): TargetHealth[] {
    return targets.map(
      (target) =>
        this.healthByTargetId.get(target.id) ?? {
          target,
          status: 'unknown',
          latestRttMs: null,
          baselineMs: null,
          jitterMs: null,
          packetLossPct: 0,
          lastSampleAt: null
        }
    )
  }
}

export interface IncidentChange {
  opened: Incident | null
  updated: Incident | null
  resolved: Incident | null
}

interface Observation {
  target: MonitorTarget
  health: TargetHealth
  recentAnomalies: boolean[]
  lastAnomalyAt: number | null
  severe: boolean
}

export class IncidentTracker {
  private readonly observations = new Map<string, Observation>()
  private active: Incident | null = null

  public constructor(
    private readonly recoveryMs = 25_000,
    private readonly correlationWindowMs = 30_000
  ) {}

  public record(
    target: MonitorTarget,
    sample: ProbeSample,
    assessment: TargetAssessment
  ): IncidentChange {
    if (sample.loadRunId !== null) return { opened: null, updated: null, resolved: null }

    const observation = this.observations.get(target.id) ?? {
      target,
      health: assessment.health,
      recentAnomalies: [],
      lastAnomalyAt: null,
      severe: false
    }
    const anomalous = assessment.anomalous && sample.loadRunId === null
    observation.target = target
    observation.health = assessment.health
    observation.severe = anomalous && assessment.severe
    observation.recentAnomalies = [...observation.recentAnomalies, anomalous].slice(-3)
    if (anomalous) observation.lastAnomalyAt = sample.completedAt
    this.observations.set(target.id, observation)

    const persistent = observation.recentAnomalies.filter(Boolean).length >= 2
    if (!anomalous || (!assessment.severe && !persistent)) return this.tick(sample.completedAt)

    const incident = this.buildIncident(sample.completedAt)
    if (!this.active) {
      this.active = incident
      return { opened: incident, updated: null, resolved: null }
    }

    this.active = { ...incident, id: this.active.id, startedAt: this.active.startedAt }
    return { opened: null, updated: this.active, resolved: null }
  }

  public tick(now: number): IncidentChange {
    if (!this.active) return { opened: null, updated: null, resolved: null }

    const hasRecentAnomaly = [...this.observations.values()].some(
      (observation) =>
        observation.lastAnomalyAt !== null && now - observation.lastAnomalyAt < this.recoveryMs
    )
    if (hasRecentAnomaly) return { opened: null, updated: null, resolved: null }

    const resolved = { ...this.active, endedAt: now }
    this.active = null
    return { opened: null, updated: null, resolved }
  }

  public getActive(): Incident | null {
    return this.active
  }

  private buildIncident(now: number): Incident {
    const affected = [...this.observations.values()].filter(
      (observation) =>
        observation.lastAnomalyAt !== null && now - observation.lastAnomalyAt <= this.correlationWindowMs
    )
    const gateways = affected.filter((observation) => observation.target.kind === 'gateway')
    const publicAnchors = affected.filter((observation) => observation.target.kind === 'public')
    const ispTargets = affected.filter((observation) => observation.target.kind === 'isp')
    const regions = new Map<string, Observation[]>()
    for (const observation of affected) {
      if (!observation.target.region) continue
      const group = regions.get(observation.target.region) ?? []
      group.push(observation)
      regions.set(observation.target.region, group)
    }
    const regionQuorum = [...regions.entries()].find(([, group]) => group.length >= 2)
    const affectedRegionCount = regions.size

    const scope = gateways.length > 0
      ? 'local'
      : regionQuorum
        ? 'region'
        : publicAnchors.length >= 2 || ispTargets.length > 0
          ? 'isp'
          : affectedRegionCount >= 2
            ? 'internet'
            : 'endpoint'
    const region = scope === 'region' ? regionQuorum?.[0] ?? null : null
    const severity = affected.some((observation) => observation.severe) ? 'critical' : 'warning'
    const confidence =
      scope === 'local' || scope === 'region'
        ? 'high'
        : scope === 'isp' || scope === 'internet'
          ? 'medium'
          : 'low'

    return {
      id: randomUUID(),
      startedAt: now,
      endedAt: null,
      scope,
      region,
      severity,
      confidence,
      summary: incidentSummary(scope, region),
      evidence: affected.map((observation) => {
        const rtt = observation.health.latestRttMs
        return rtt === null
          ? `${observation.target.name}: ${observation.health.status}`
          : `${observation.target.name}: ${rtt.toFixed(1)} ms (${observation.health.status})`
      })
    }
  }
}

function incidentSummary(scope: Incident['scope'], region: string | null): string {
  switch (scope) {
    case 'local':
      return 'The default gateway is affected; the local network is the leading suspect.'
    case 'isp':
      return 'Multiple upstream anchors are affected; the ISP path is a likely contributor.'
    case 'internet':
      return 'Independent regions are affected; the issue extends beyond a single endpoint.'
    case 'region':
      return `${region ?? 'This'} regional path has corroborating endpoint failures.`
    default:
      return 'One endpoint is affected; there is not enough evidence for a broader incident.'
  }
}
