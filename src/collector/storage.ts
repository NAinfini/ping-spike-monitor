import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type {
  HealthStatus,
  Incident,
  MonitorTarget,
  OverviewSnapshot,
  ProbeSample,
  SeriesPoint,
  SeriesQuery,
  TargetHealth,
  TargetKind,
  ProbeMethod,
  SampleStatus
} from '../shared/types'

const DEFAULT_TARGETS: MonitorTarget[] = [
  {
    id: 'anchor-cloudflare',
    name: 'Cloudflare public anchor',
    kind: 'public',
    region: null,
    address: '1.1.1.1',
    method: 'icmp',
    intervalMs: 2_000,
    timeoutMs: 1_500,
    enabled: true
  },
  {
    id: 'anchor-google',
    name: 'Google public anchor',
    kind: 'public',
    region: null,
    address: '8.8.8.8',
    method: 'icmp',
    intervalMs: 2_000,
    timeoutMs: 1_500,
    enabled: true
  }
]

type Row = Record<string, SQLOutputValue>

function asNumber(value: SQLOutputValue | undefined): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function asNullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : asNumber(value)
}

function asString(value: SQLOutputValue | undefined): string {
  return String(value ?? '')
}

function asNullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toTarget(row: Row): MonitorTarget {
  return {
    id: asString(row.id),
    name: asString(row.name),
    kind: asString(row.kind) as TargetKind,
    region: asNullableString(row.region),
    address: asString(row.address),
    method: asString(row.method) as ProbeMethod,
    intervalMs: asNumber(row.interval_ms),
    timeoutMs: asNumber(row.timeout_ms),
    enabled: Boolean(asNumber(row.enabled))
  }
}

function toSample(row: Row): ProbeSample {
  return {
    id: asNumber(row.id),
    targetId: asString(row.target_id),
    scheduledAt: asNumber(row.scheduled_at),
    completedAt: asNumber(row.completed_at),
    status: asString(row.status) as SampleStatus,
    rttMs: asNullableNumber(row.rtt_ms),
    errorCode: asNullableString(row.error_code),
    loadRunId: asNullableString(row.load_run_id)
  }
}

function toIncident(row: Row): Incident {
  let evidence: string[] = []
  try {
    const parsed: unknown = JSON.parse(asString(row.evidence_json))
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) evidence = parsed
  } catch {
    evidence = []
  }

  return {
    id: asString(row.id),
    startedAt: asNumber(row.started_at),
    endedAt: asNullableNumber(row.ended_at),
    scope: asString(row.scope) as Incident['scope'],
    region: asNullableString(row.region),
    severity: asString(row.severity) as Incident['severity'],
    confidence: asString(row.confidence) as Incident['confidence'],
    summary: asString(row.summary),
    evidence
  }
}

function overallStatus(targetHealth: TargetHealth[]): HealthStatus {
  const statuses = targetHealth.map((health) => health.status)
  if (statuses.includes('down')) return 'down'
  if (statuses.includes('degraded')) return 'degraded'
  if (statuses.length > 0 && statuses.every((status) => status === 'healthy')) return 'healthy'
  if (statuses.includes('warming')) return 'warming'
  return 'unknown'
}

export class CollectorStorage {
  private readonly database: DatabaseSync
  private readonly insertTarget
  private readonly updateGateway
  private readonly disableGateway
  private readonly selectTarget
  private readonly selectTargets
  private readonly insertSample
  private readonly selectIncidents
  private readonly upsertIncident
  private readonly selectSamplesSince
  private readonly resolveInterruptedIncidents

  public constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        region TEXT,
        address TEXT NOT NULL,
        method TEXT NOT NULL,
        interval_ms INTEGER NOT NULL CHECK(interval_ms > 0),
        timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id),
        scheduled_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        rtt_ms REAL,
        error_code TEXT,
        load_run_id TEXT
      );

      CREATE INDEX IF NOT EXISTS samples_target_scheduled_at
        ON samples(target_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS samples_completed_at ON samples(completed_at);

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        scope TEXT NOT NULL,
        region TEXT,
        severity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS incidents_started_at ON incidents(started_at DESC);
    `)

    this.insertTarget = this.database.prepare(`
      INSERT INTO targets (id, name, kind, region, address, method, interval_ms, timeout_ms, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    this.updateGateway = this.database.prepare('UPDATE targets SET address = ?, enabled = 1 WHERE id = ?')
    this.disableGateway = this.database.prepare('UPDATE targets SET enabled = 0 WHERE id = ?')
    this.selectTarget = this.database.prepare('SELECT * FROM targets WHERE id = ?')
    this.selectTargets = this.database.prepare('SELECT * FROM targets ORDER BY kind, name')
    this.insertSample = this.database.prepare(`
      INSERT INTO samples (target_id, scheduled_at, completed_at, status, rtt_ms, error_code, load_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectIncidents = this.database.prepare(
      'SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?'
    )
    this.upsertIncident = this.database.prepare(`
      INSERT INTO incidents (
        id, started_at, ended_at, scope, region, severity, confidence, summary, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ended_at = excluded.ended_at,
        scope = excluded.scope,
        region = excluded.region,
        severity = excluded.severity,
        confidence = excluded.confidence,
        summary = excluded.summary,
        evidence_json = excluded.evidence_json
    `)
    this.selectSamplesSince = this.database.prepare(`
      SELECT * FROM samples WHERE completed_at >= ? ORDER BY scheduled_at ASC, id ASC
    `)
    this.resolveInterruptedIncidents = this.database.prepare(`
      UPDATE incidents
      SET ended_at = MAX(
        started_at,
        COALESCE((SELECT MAX(completed_at) FROM samples), started_at)
      )
      WHERE ended_at IS NULL
    `)
  }

  public seedDefaultTargets(gateway: string | null): MonitorTarget[] {
    for (const target of DEFAULT_TARGETS) this.insertTarget.run(...targetValues(target))

    if (gateway) {
      const existing = this.selectTarget.get('gateway') as Row | undefined
      if (existing) {
        this.updateGateway.run(gateway, 'gateway')
      } else {
        this.insertTarget.run(
          ...targetValues({
            id: 'gateway',
            name: 'Default gateway',
            kind: 'gateway',
            region: null,
            address: gateway,
            method: 'icmp',
            intervalMs: 2_000,
            timeoutMs: 1_500,
            enabled: true
          })
        )
      }
    } else {
      this.disableGateway.run('gateway')
    }

    return this.listTargets()
  }

  public listTargets(): MonitorTarget[] {
    return this.selectTargets.all().map((row) => toTarget(row))
  }

  public writeSample(sample: ProbeSample): ProbeSample {
    const result = this.insertSample.run(
      sample.targetId,
      sample.scheduledAt,
      sample.completedAt,
      sample.status,
      sample.rttMs,
      sample.errorCode,
      sample.loadRunId
    )

    return { ...sample, id: Number(result.lastInsertRowid) }
  }

  public loadSamplesSince(from: number): ProbeSample[] {
    return this.selectSamplesSince.all(from).map((row) => toSample(row))
  }

  public querySeries(query: SeriesQuery): SeriesPoint[] {
    if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.to < query.from) {
      throw new Error('Invalid series range')
    }
    if (query.targetIds.length === 0) return []

    const requestedMaxPoints = query.maxPoints ?? 2_000
    const maxPoints = Number.isFinite(requestedMaxPoints)
      ? Math.min(2_000, Math.max(1, Math.floor(requestedMaxPoints)))
      : 2_000
    const bucketMs = Math.max(1, Math.ceil((query.to - query.from + 1) / maxPoints))
    const targetPlaceholders = query.targetIds.map(() => '?').join(', ')
    const statement = this.database.prepare(`
      SELECT
        MIN(scheduled_at) AS timestamp,
        target_id,
        MIN(CASE WHEN status = 'ok' THEN rtt_ms END) AS min_ms,
        AVG(CASE WHEN status = 'ok' THEN rtt_ms END) AS avg_ms,
        MAX(CASE WHEN status = 'ok' THEN rtt_ms END) AS max_ms,
        100.0 * SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) / COUNT(*) AS packet_loss_pct
      FROM samples
      WHERE scheduled_at BETWEEN ? AND ? AND target_id IN (${targetPlaceholders})
      GROUP BY target_id, CAST((scheduled_at - ?) / ? AS INTEGER)
      ORDER BY timestamp ASC, target_id ASC
    `)
    const rows = statement.all(query.from, query.to, ...query.targetIds, query.from, bucketMs)

    return rows.map((row) => ({
      timestamp: asNumber(row.timestamp),
      targetId: asString(row.target_id),
      minMs: asNullableNumber(row.min_ms),
      avgMs: asNullableNumber(row.avg_ms),
      maxMs: asNullableNumber(row.max_ms),
      packetLossPct: asNumber(row.packet_loss_pct)
    }))
  }

  public writeIncident(incident: Incident): void {
    this.upsertIncident.run(
      incident.id,
      incident.startedAt,
      incident.endedAt,
      incident.scope,
      incident.region,
      incident.severity,
      incident.confidence,
      incident.summary,
      JSON.stringify(incident.evidence)
    )
  }

  public listIncidents(limit = 50): Incident[] {
    return this.selectIncidents.all(Math.max(1, Math.min(500, Math.floor(limit)))).map((row) => toIncident(row))
  }

  public closeInterruptedIncidents(): void {
    this.resolveInterruptedIncidents.run()
  }

  public getOverview(
    collectorStartedAt: number,
    targetHealth: TargetHealth[],
    activeIncident: Incident | null,
    lastUpdatedAt = Date.now()
  ): OverviewSnapshot {
    return {
      collectorStartedAt,
      lastUpdatedAt,
      status: overallStatus(targetHealth),
      targetHealth,
      activeIncident,
      recentIncidents: this.listIncidents(10)
    }
  }

  public integrityCheck(): boolean {
    const row = this.database.prepare('PRAGMA integrity_check').get()
    return asString(row?.integrity_check) === 'ok'
  }

  public close(): void {
    this.database.close()
  }
}

function targetValues(target: MonitorTarget): [
  string,
  string,
  string,
  string | null,
  string,
  string,
  number,
  number,
  number
] {
  return [
    target.id,
    target.name,
    target.kind,
    target.region,
    target.address,
    target.method,
    target.intervalMs,
    target.timeoutMs,
    target.enabled ? 1 : 0
  ]
}
