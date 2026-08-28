import type { MonitorTarget } from '../shared/types'

export type ScheduledTask = (target: MonitorTarget, scheduledAt: number) => Promise<void>

interface ScheduledJob {
  target: MonitorTarget
  nextDueAt: number
  running: boolean
}

export class AbsoluteScheduler {
  private readonly jobs = new Map<string, ScheduledJob>()
  private timer: NodeJS.Timeout | null = null
  private started = false

  public constructor(
    private readonly task: ScheduledTask,
    private readonly now: () => number = Date.now
  ) {}

  public replaceTargets(targets: MonitorTarget[]): void {
    const currentTime = this.now()
    const nextJobs = new Map<string, ScheduledJob>()

    for (const target of targets.filter((candidate) => candidate.enabled)) {
      const existing = this.jobs.get(target.id)
      if (existing) {
        existing.target = target
        nextJobs.set(target.id, existing)
      } else {
        nextJobs.set(target.id, { target, nextDueAt: currentTime, running: false })
      }
    }

    this.jobs.clear()
    for (const [id, job] of nextJobs) this.jobs.set(id, job)
    if (this.started) this.arm()
  }

  public start(): void {
    if (this.started) return
    this.started = true
    this.runDue()
  }

  public stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  public runDue(currentTime = this.now()): void {
    for (const job of this.jobs.values()) {
      if (currentTime < job.nextDueAt) continue

      const scheduledAt = job.nextDueAt
      const intervalMs = Math.max(1, job.target.intervalMs)
      const elapsedIntervals = Math.floor((currentTime - scheduledAt) / intervalMs) + 1
      job.nextDueAt = scheduledAt + elapsedIntervals * intervalMs

      if (job.running) continue
      job.running = true
      void this.task(job.target, scheduledAt)
        .catch(() => undefined)
        .finally(() => {
          job.running = false
          if (this.started) this.arm()
        })
    }

    if (this.started) this.arm()
  }

  private arm(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)

    const nextDueAt = Math.min(...[...this.jobs.values()].map((job) => job.nextDueAt))
    if (!Number.isFinite(nextDueAt)) return

    const delay = Math.max(0, nextDueAt - this.now())
    this.timer = setTimeout(() => this.runDue(), delay)
  }
}
