import assert from 'node:assert/strict'
import test from 'node:test'
import type { Incident, MonitorTarget, ProbeSample, TargetHealth } from '../src/shared/types'
import { CollectorRuntime, resolveCollectorDataDirectory } from '../src/collector/index'
import { assessTarget, IncidentTracker, type TargetAssessment } from '../src/collector/health'
import {
  discoverDefaultGateway,
  parseDefaultGateway,
  parsePingRtt,
  pingTarget,
  type CommandRunner
} from '../src/collector/probe'
import { AbsoluteScheduler } from '../src/collector/scheduler'
import { CollectorStorage } from '../src/collector/storage'

const gateway: MonitorTarget = {
  id: 'gateway',
  name: 'Default gateway',
  kind: 'gateway',
  region: null,
  address: '192.168.1.1',
  method: 'icmp',
  intervalMs: 10,
  timeoutMs: 50,
  enabled: true
}

function sample(
  targetId: string,
  scheduledAt: number,
  status: ProbeSample['status'] = 'ok',
  rttMs: number | null = status === 'ok' ? 20 : null
): ProbeSample {
  return {
    targetId,
    scheduledAt,
    completedAt: scheduledAt + 1,
    status,
    rttMs,
    errorCode: status === 'ok' ? null : status,
    loadRunId: null
  }
}

test('discovers Windows default route and parses Windows ping output without a network call', async () => {
  const routeOutput = `
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.50.1   192.168.50.22     25
`
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    return { stdout: routeOutput, stderr: '', exitCode: 0, timedOut: false, spawnError: false }
  }

  assert.equal(parseDefaultGateway(routeOutput), '192.168.50.1')
  assert.equal(await discoverDefaultGateway(runner, 'win32'), '192.168.50.1')
  assert.deepEqual(calls, [{ file: 'route.exe', args: ['print', '-4', '0.0.0.0'] }])
  assert.equal(parsePingRtt('Reply from 1.1.1.1: bytes=32 time=17ms TTL=57'), 17)
  assert.equal(parsePingRtt('Reply from 1.1.1.1: bytes=32 time<1ms TTL=57'), 0.5)

  const ping = await pingTarget(
    gateway,
    100,
    async () => ({
      stdout: 'Request timed out.',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      spawnError: false
    }),
    () => 101
  )
  assert.deepEqual(ping, sample('gateway', 100, 'timeout', null))

  const unreachable = await pingTarget(
    gateway,
    200,
    async () => ({
      stdout: 'Reply from 192.168.1.10: Destination host unreachable.',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      spawnError: false
    }),
    () => 201
  )
  assert.deepEqual(unreachable, sample('gateway', 200, 'timeout', null))
})

test('absolute scheduler skips missed deadlines and never overlaps a target', async () => {
  let currentTime = 0
  let releaseFirst!: () => void
  const firstRun = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const calls: number[] = []
  const scheduler = new AbsoluteScheduler(async (_target, scheduledAt) => {
    calls.push(scheduledAt)
    if (calls.length === 1) await firstRun
  }, () => currentTime)

  scheduler.replaceTargets([gateway])
  scheduler.runDue()
  currentTime = 15
  scheduler.runDue()
  assert.deepEqual(calls, [0])

  releaseFirst()
  await new Promise<void>((resolve) => setImmediate(resolve))
  currentTime = 20
  scheduler.runDue()
  assert.deepEqual(calls, [0, 20])
})

test('SQLite seeds anchors, preserves samples, aggregates series, and persists incidents', () => {
  const storage = new CollectorStorage(':memory:')
  try {
    const targets = storage.seedDefaultTargets('192.168.1.1')
    assert.deepEqual(
      targets.map((target) => target.id).sort(),
      ['anchor-cloudflare', 'anchor-google', 'gateway']
    )

    storage.writeSample(sample('gateway', 0, 'ok', 10))
    storage.writeSample(sample('gateway', 1_000, 'timeout', null))
    storage.writeSample(sample('gateway', 2_000, 'ok', 50))
    const series = storage.querySeries({ from: 0, to: 3_000, targetIds: ['gateway'], maxPoints: 2 })
    assert.equal(series.length, 2)
    assert.deepEqual(series[0], {
      timestamp: 0,
      targetId: 'gateway',
      minMs: 10,
      avgMs: 10,
      maxMs: 10,
      packetLossPct: 50
    })
    assert.deepEqual(series[1], {
      timestamp: 2_000,
      targetId: 'gateway',
      minMs: 50,
      avgMs: 50,
      maxMs: 50,
      packetLossPct: 0
    })

    const incident: Incident = {
      id: 'incident-1',
      startedAt: 2_000,
      endedAt: null,
      scope: 'local',
      region: null,
      severity: 'critical',
      confidence: 'high',
      summary: 'Gateway timeout',
      evidence: ['Default gateway: down']
    }
    storage.writeIncident(incident)
    assert.deepEqual(storage.listIncidents(), [incident])
    storage.closeInterruptedIncidents()
    assert.equal(storage.listIncidents()[0]?.endedAt, 2_001)
    assert.equal(storage.integrityCheck(), true)
  } finally {
    storage.close()
  }
})

test('baseline flags sustained spikes and incidents require persistence unless severe', () => {
  const history = Array.from({ length: 10 }, (_, index) => sample('gateway', index * 10, 'ok', 20))
  const assessment = assessTarget(gateway, history, sample('gateway', 200, 'ok', 180))
  assert.equal(assessment.health.baselineMs, 20)
  assert.equal(assessment.health.status, 'degraded')
  assert.equal(assessment.anomalous, true)
  assert.equal(assessment.severe, false)

  const tracker = new IncidentTracker(25_000)
  const health: TargetHealth = {
    ...assessment.health,
    status: 'degraded',
    latestRttMs: 180,
    lastSampleAt: 201
  }
  const warning: TargetAssessment = { health, anomalous: true, severe: false }
  assert.equal(tracker.record(gateway, sample('gateway', 200, 'ok', 180), warning).opened, null)
  const opened = tracker.record(gateway, sample('gateway', 210, 'ok', 190), warning).opened
  assert.equal(opened?.scope, 'local')
  assert.equal(opened?.severity, 'warning')

  const loadSample = { ...sample('gateway', 25_210, 'ok', 20), loadRunId: 'speed-run-1' }
  assert.deepEqual(tracker.record(gateway, loadSample, warning), {
    opened: null,
    updated: null,
    resolved: null
  })
  assert.notEqual(tracker.getActive(), null)
  assert.equal(tracker.tick(25_211).resolved?.endedAt, 25_211)
})

test('runtime accepts IPC-shaped requests with a fake probe and data directory uses the override', async () => {
  const storage = new CollectorStorage(':memory:')
  const runtime = new CollectorRuntime({
    storage,
    discoverGateway: async () => null,
    probe: async (target, scheduledAt) => sample(target.id, scheduledAt, 'ok', 15)
  })
  try {
    await runtime.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const response = await runtime.handleRequest({ type: 'request', requestId: 'targets', method: 'targets' })
    assert.equal(response.ok, true)
    assert.equal(Array.isArray(response.result), true)
    assert.equal(resolveCollectorDataDirectory({ PING_SPIKE_DATA_DIR: 'D:\\monitor-data' }), 'D:\\monitor-data')
  } finally {
    runtime.stop()
  }
})
